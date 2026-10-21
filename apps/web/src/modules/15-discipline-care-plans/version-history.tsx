import {
  DerivedBadge,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  t,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/15-discipline-care-plans — the VERSION HISTORY (§5.1 #13, Track B / ADR-0030).
// Spec layout: "Use Detail Page."
//
// The version chain for one plan kind, with the SEALED snapshot of whichever version is selected. The
// snapshot is what the signers actually attested to — sealed at the `in_review` transition, never
// recomputed — so it is rendered as a sealed block, not as live plan content that could have moved since.
//
// The §5.1 "signed-version diff" is a per-field comparison of two sealed snapshots. It is honest here at
// the level the snapshot's shape allows: the two selected versions' snapshots are diffed key by key at the
// top level. A deeper structural diff waits on the §3.4 per-kind schemas being published to the client.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import {
  type VersionDetail,
  type VersionListItem,
  errorMessage,
  getPlanByKind,
  getVersion,
  listVersions,
  normalizeSignerSet,
} from "./discipline-api";
import {
  VERSION_STATUS_TONE,
  dateTime,
  humanize,
  kindLabel,
  shortId,
  toneOf,
} from "./discipline-status";
import {
  Card,
  Field,
  SummaryGrid,
  alertStyle,
  columnStyle,
  ghostButtonStyle,
  linkStyle,
  mutedStyle,
  pageTitleStyle,
  rowLine,
  tableStyle,
  td,
  th,
} from "./discipline-ui";

/** Top-level key diff between two sealed snapshots — added / removed / changed. */
function diffSnapshots(a: unknown, b: unknown): { key: string; before: string; after: string }[] {
  const left = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
  const right = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  const out: { key: string; before: string; after: string }[] = [];
  for (const key of keys) {
    const before = JSON.stringify(left[key] ?? null);
    const after = JSON.stringify(right[key] ?? null);
    if (before !== after) out.push({ key, before, after });
  }
  return out;
}

export function DisciplineVersionHistory(): JSX.Element {
  const client = useApiClient();
  const { patientId, kind } = useParams<{ patientId: string; kind: string }>();
  const [planId, setPlanId] = useState<string | null>(null);
  const [rows, setRows] = useState<VersionListItem[]>([]);
  const [selected, setSelected] = useState<VersionDetail | null>(null);
  const [compare, setCompare] = useState<VersionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!patientId || !kind) return;
    setLoading(true);
    setError(null);
    const { plan, error: planErr } = await getPlanByKind(client, patientId, kind);
    if (planErr || !plan) {
      setError(errorMessage(planErr, `No ${kindLabel(kind)} is available for this patient.`));
      setLoading(false);
      return;
    }
    setPlanId(plan.planId);
    const { page, error: err } = await listVersions(client, plan.planId);
    if (err) {
      setError(errorMessage(err, "The version chain could not be loaded."));
      setLoading(false);
      return;
    }
    setRows(page?.data ?? []);
    setLoading(false);
  }, [client, patientId, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = useCallback(
    async (versionId: string, slot: "selected" | "compare") => {
      if (!planId) return;
      setDetailError(null);
      const { version, error: err } = await getVersion(client, planId, versionId);
      if (err || !version) {
        setDetailError(errorMessage(err, "That version could not be opened."));
        return;
      }
      if (slot === "selected") setSelected(version);
      else setCompare(version);
    },
    [client, planId],
  );

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  const diff =
    selected && compare ? diffSnapshots(compare.stateSnapshot, selected.stateSnapshot) : [];

  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>{kindLabel(kind)} — version history</span>}
        breadcrumb="Clinical — sealed version chain"
        actions={
          <Link to={`/patients/${patientId}/discipline-plans`} style={ghostButtonStyle}>
            All discipline plans
          </Link>
        }
      />

      {detailError ? <p style={alertStyle}>{detailError}</p> : null}

      <Card title="Versions">
        {rows.length === 0 ? (
          <span style={mutedStyle}>This plan has no versions yet.</span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Version</th>
                <th style={th}>Kind</th>
                <th style={th}>IDG meeting</th>
                <th style={th}>Finalized</th>
                <th style={th}>Signed</th>
                <th style={th}>Superseded</th>
                <th style={th}>Status</th>
                <th style={th}>&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.versionId} style={rowLine}>
                  <td style={td}>v{v.sequence}</td>
                  <td style={td}>{humanize(v.kind)}</td>
                  <td style={td}>{shortId(v.idgMeetingId)}</td>
                  <td style={td}>{dateTime(v.finalizedAt)}</td>
                  <td style={td}>{dateTime(v.signedAt)}</td>
                  <td style={td}>{dateTime(v.supersededAt)}</td>
                  <td style={td}>
                    <StatusPill
                      label={humanize(v.status)}
                      tone={toneOf(VERSION_STATUS_TONE, v.status)}
                    />
                  </td>
                  <td style={td}>
                    <div style={{ display: "flex", gap: t.space2 }}>
                      <button
                        type="button"
                        style={ghostButtonStyle}
                        onClick={() => void open(v.versionId, "selected")}
                      >
                        Open
                      </button>
                      <button
                        type="button"
                        style={ghostButtonStyle}
                        onClick={() => void open(v.versionId, "compare")}
                      >
                        Compare against
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {selected ? (
        <Card title={`Version ${selected.sequence} — sealed snapshot`}>
          <SummaryGrid>
            <Field label="Status" value={humanize(selected.status)} />
            <Field label="Finalized" value={dateTime(selected.finalizedAt)} />
            <Field label="Signed" value={dateTime(selected.signedAt)} />
          </SummaryGrid>
          <h4
            style={{
              margin: 0,
              fontFamily: t.fontDisplay,
              fontSize: "0.85rem",
              color: t.onSurface,
            }}
          >
            Required signer set (frozen at finalize)
          </h4>
          {normalizeSignerSet(selected.requiredSignerSet).length === 0 ? (
            <span style={mutedStyle}>
              No quorum is recorded on this version — a discharge version is sealed by the system
              actor and carries none.
            </span>
          ) : (
            <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
              {normalizeSignerSet(selected.requiredSignerSet).map((slot) => (
                <li
                  key={`${slot.role}-${slot.isAcknowledgment}`}
                  style={{ fontSize: "0.82rem", color: t.onSurface }}
                >
                  {humanize(slot.role)} × {slot.count}
                  {slot.isAcknowledgment ? " (acknowledgment)" : ""}
                </li>
              ))}
            </ul>
          )}
          <h4
            style={{
              margin: 0,
              fontFamily: t.fontDisplay,
              fontSize: "0.85rem",
              color: t.onSurface,
            }}
          >
            Signatures collected
          </h4>
          {selected.signatures.length === 0 ? (
            <span style={mutedStyle}>No signature collected yet.</span>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={th}>Signer</th>
                  <th style={th}>Role</th>
                  <th style={th}>Kind</th>
                  <th style={th}>Signed</th>
                </tr>
              </thead>
              <tbody>
                {selected.signatures.map((s) => (
                  <tr key={s.signatureId} style={rowLine}>
                    <td style={td}>{shortId(s.signerMembershipId)}</td>
                    <td style={td}>{humanize(s.signerRole)}</td>
                    <td style={td}>{s.isAcknowledgment ? "Acknowledgment" : "Signature"}</td>
                    <td style={td}>{dateTime(s.signedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: t.space2 }}>
            <h4
              style={{
                margin: 0,
                fontFamily: t.fontDisplay,
                fontSize: "0.85rem",
                color: t.onSurface,
              }}
            >
              Sealed plan snapshot
            </h4>
            <DerivedBadge source="the plan at finalize" verb="computed from" />
          </div>
          <pre
            style={{
              margin: 0,
              padding: t.space3,
              borderRadius: t.radiusMd,
              background: t.surfaceLow,
              fontFamily: t.fontMono,
              fontSize: "0.75rem",
              whiteSpace: "pre-wrap",
              color: t.onSurface,
            }}
          >
            {JSON.stringify(selected.stateSnapshot ?? {}, null, 2)}
          </pre>
        </Card>
      ) : null}

      {selected && compare ? (
        <Card title={`Diff — v${compare.sequence} → v${selected.sequence}`}>
          {diff.length === 0 ? (
            <span style={mutedStyle}>The two sealed snapshots are identical at the top level.</span>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={th}>Field</th>
                  <th style={th}>v{compare.sequence}</th>
                  <th style={th}>v{selected.sequence}</th>
                </tr>
              </thead>
              <tbody>
                {diff.map((d) => (
                  <tr key={d.key} style={rowLine}>
                    <td style={{ ...td, fontFamily: t.fontMono }}>{d.key}</td>
                    <td style={{ ...td, fontFamily: t.fontMono, fontSize: "0.75rem" }}>
                      {d.before}
                    </td>
                    <td style={{ ...td, fontFamily: t.fontMono, fontSize: "0.75rem" }}>
                      {d.after}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Link to={`/patients/${patientId}/discipline-plans/${kind}/versions`} style={linkStyle}>
            Clear comparison by reloading
          </Link>
        </Card>
      ) : null}
    </div>
  );
}
