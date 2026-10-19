// apps/web/src/modules/05-patient — the Privacy Officer screen for one patient (M5 §5.1 "Privacy flags
// (`/patients/:id/privacy`) — read-only summary of current snapshot + capture time + staleness indicator +
// 'Resync from consent' button (Privacy Officer only). Below: timeline of flag changes drawn from Module 4
// audit events"). Reads GET /api/v1/patients/:id/privacy and posts the §4.2 resync; both are
// `privacy.admin`, the SERVER is the only enforcer (ADR-0030).
//
// Shows each restriction with its origin and since-when, the 42 CFR Part 2 consent state, the WardenLens
// intake packets holding a detection (ids, dates and page counts — never content), drift between the
// snapshot and its sources, the change timeline, and who can clear what. The officer does NOT confirm or
// reject a detection here — that is the licensed reviewer's act in the intake review (M22 §7.4 step 6),
// so each packet links there.
import { formatMrn } from "@wardenx/types";
import {
  Button,
  Card,
  DetailPageLayout,
  EmptyState,
  ErrorState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  t,
  useApiClient,
} from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import {
  DRIFT_TEXT,
  ORIGIN_CLEARANCE,
  ORIGIN_LABEL,
  ORIGIN_TONE,
  type PrivacyDrift,
  type PrivacyFlagOrigin,
  SUD_STATUS_PILL,
  privacyFlagLabel,
  usDateTime,
} from "./privacy-model";

export interface PatientPrivacyView {
  patient: { id: string; displayName: string; mrn: string; status: string };
  snapshot: {
    exists: boolean;
    flags: string[];
    capturedAt: string | null;
    stale: boolean;
    invalidatedAt: string | null;
    sourceConsentVersion: string | null;
  };
  restrictions: {
    flag: string;
    origin: PrivacyFlagOrigin;
    since: string | null;
    sinceFromHistory: boolean;
  }[];
  part2Consent: {
    state: "active" | "inactive" | "none";
    consentRecordId: string | null;
    status: string | null;
    effectiveAt: string | null;
    expiresAt: string | null;
    revokedAt: string | null;
  };
  intakeDetections: {
    batchId: string;
    sudStatus: "detected" | "confirmed" | "rejected";
    batchStatus: string;
    receivedAt: string;
    pageCount: number | null;
    resolvedAt: string | null;
    contributes: boolean;
  }[];
  history: {
    at: string;
    actorUserId: string | null;
    action: "insert" | "update" | "delete";
    flagsBefore: string[];
    flagsAfter: string[];
    sudOriginAfter: string | null;
  }[];
  drift: PrivacyDrift[];
}

interface ResyncResult {
  flagsBefore: string[];
  flagsAfter: string[];
  flagsChanged: boolean;
}

const flagList = (flags: string[]): string =>
  flags.length === 0 ? "none" : flags.map(privacyFlagLabel).join(", ");

const sectionTitle = {
  margin: `0 0 ${t.space3}`,
  fontSize: "1rem",
  fontWeight: 600,
  color: t.onSurface,
} as const;
const muted = { color: t.onSurfaceVariant, fontSize: "0.85rem" } as const;
const stack = { display: "grid", gap: t.space4 } as const;

function consentSummary(c: PatientPrivacyView["part2Consent"]): {
  label: string;
  tone: "success" | "warning" | "neutral";
  detail: string;
} {
  if (c.state === "active") {
    return {
      label: "Part 2 release in force",
      tone: "success",
      detail: `Effective ${usDateTime(c.effectiveAt)}${c.expiresAt ? ` · expires ${usDateTime(c.expiresAt)}` : " · no expiry"}`,
    };
  }
  if (c.state === "inactive") {
    return {
      label: `No release in force (${c.status ?? "inactive"})`,
      tone: "warning",
      detail: c.revokedAt
        ? `Revoked ${usDateTime(c.revokedAt)}`
        : c.expiresAt
          ? `Expired ${usDateTime(c.expiresAt)}`
          : `Effective ${usDateTime(c.effectiveAt)}`,
    };
  }
  return {
    label: "No Part 2 release on file",
    tone: "neutral",
    detail: "Consents hold no 42 CFR Part 2 release for this patient.",
  };
}

export function PatientPrivacy(): JSX.Element {
  const client = useApiClient();
  const { id } = useParams<{ id: string }>();
  const [view, setView] = useState<PatientPrivacyView | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "not_found" | "error">("loading");
  const [resyncing, setResyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [resyncError, setResyncError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    const r = await client.GET("/api/v1/patients/{id}/privacy", { params: { path: { id } } });
    if (r.error || !r.data) {
      setState(r.response?.status === 404 ? "not_found" : "error");
      return;
    }
    setView(r.data as PatientPrivacyView);
    setState("ready");
  }, [client, id]);

  useEffect(() => {
    setState("loading");
    void load();
  }, [load]);

  const resync = async () => {
    if (!id) return;
    setResyncing(true);
    setNotice(null);
    setResyncError(null);
    const r = await client.POST("/api/v1/patients/{id}/privacy-flags/resync", {
      params: { path: { id } },
    });
    setResyncing(false);
    if (r.error || !r.data) {
      setResyncError("Re-sync failed. The restrictions shown are unchanged.");
      return;
    }
    const out = r.data as ResyncResult;
    setNotice(
      out.flagsChanged
        ? `Re-synced from consents. Restrictions: ${flagList(out.flagsBefore)} → ${flagList(out.flagsAfter)}.`
        : "Re-synced from consents. No change to the restrictions.",
    );
    await load();
  };

  if (state === "loading") return <LoadingSpinner />;
  if (state === "not_found") {
    return (
      <EmptyState title="Patient not found" description="No patient with this id is visible." />
    );
  }
  if (state === "error" || !view) {
    return (
      <ErrorState
        title="Privacy restrictions unavailable"
        description="The restrictions could not be loaded. Protected details stay sealed while this state is unknown."
        onRetry={() => void load()}
      />
    );
  }

  const consent = consentSummary(view.part2Consent);
  const origins = [...new Set(view.restrictions.map((r) => r.origin))];

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title="Privacy restrictions"
          breadcrumb={
            <>
              <Link to="/compliance/privacy">Privacy restrictions</Link> /{" "}
              <Link to={`/patients/${view.patient.id}`}>{view.patient.displayName}</Link>
            </>
          }
          actions={
            <Button loading={resyncing} onClick={() => void resync()}>
              Re-sync from consents
            </Button>
          }
        >
          <div style={muted}>
            {formatMrn(view.patient.mrn)} · re-sync re-reads the patient's consent state. It never
            lifts a WardenLens detection.
          </div>
        </PageHeader>
      }
      aside={
        <aside style={{ width: "20rem", flexShrink: 0, padding: t.space5 }}>
          <Card>
            <h2 style={sectionTitle}>Snapshot</h2>
            <div style={{ display: "grid", gap: t.space3, fontSize: "0.85rem" }}>
              <div>
                <div style={muted}>Status</div>
                {view.snapshot.stale ? (
                  <StatusPill label="Stale — re-sync needed" tone="warning" glyph="alert" />
                ) : view.snapshot.exists ? (
                  <StatusPill label="Current" tone="success" />
                ) : (
                  <StatusPill label="No snapshot yet" tone="neutral" />
                )}
              </div>
              <div>
                <div style={muted}>Captured</div>
                {usDateTime(view.snapshot.capturedAt)}
              </div>
              {view.snapshot.invalidatedAt ? (
                <div>
                  <div style={muted}>Marked stale</div>
                  {usDateTime(view.snapshot.invalidatedAt)}
                </div>
              ) : null}
              <div>
                <div style={muted}>Active restrictions</div>
                {view.snapshot.flags.length}
              </div>
            </div>
          </Card>
        </aside>
      }
    >
      <div style={stack}>
        {notice ? (
          <output aria-label="Re-sync result" style={{ ...muted, color: t.onSurface }}>
            {notice}
          </output>
        ) : null}
        {resyncError ? (
          <div role="alert" style={{ color: t.error }}>
            {resyncError}
          </div>
        ) : null}

        {view.drift.length > 0 ? (
          <Card aria-label="Out of step with sources">
            <h2 style={sectionTitle}>Out of step with its sources</h2>
            <ul style={{ margin: 0, paddingLeft: "1.2rem", display: "grid", gap: t.space2 }}>
              {view.drift.map((d) => (
                <li key={d}>{DRIFT_TEXT[d]}</li>
              ))}
            </ul>
          </Card>
        ) : null}

        <Card aria-label="Restrictions">
          <h2 style={sectionTitle}>Restrictions</h2>
          {view.restrictions.length === 0 ? (
            <p style={muted}>No privacy restriction is recorded for this patient.</p>
          ) : (
            <table className="tabular-nums" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Category</th>
                  <th style={{ textAlign: "left" }}>Origin</th>
                  <th style={{ textAlign: "left" }}>Since</th>
                </tr>
              </thead>
              <tbody>
                {view.restrictions.map((r) => (
                  <tr key={r.flag}>
                    <td>{privacyFlagLabel(r.flag)}</td>
                    <td>
                      <StatusPill label={ORIGIN_LABEL[r.origin]} tone={ORIGIN_TONE[r.origin]} />
                    </td>
                    <td>
                      {usDateTime(r.since)}
                      {r.sinceFromHistory ? null : <span style={muted}> (snapshot time)</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card aria-label="42 CFR Part 2 consent">
          <h2 style={sectionTitle}>42 CFR Part 2 consent</h2>
          <StatusPill label={consent.label} tone={consent.tone} />
          <p style={{ ...muted, marginBottom: 0 }}>{consent.detail}</p>
        </Card>

        <Card aria-label="WardenLens detections">
          <h2 style={sectionTitle}>WardenLens detections</h2>
          {view.intakeDetections.length === 0 ? (
            <p style={muted}>
              No intake packet for this patient carries a substance-use detection.
            </p>
          ) : (
            <table className="tabular-nums" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Packet</th>
                  <th style={{ textAlign: "left" }}>Detection</th>
                  <th style={{ textAlign: "left" }}>Received</th>
                  <th style={{ textAlign: "left" }}>Pages</th>
                  <th style={{ textAlign: "left" }}>Holds the flag</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {view.intakeDetections.map((b) => {
                  const pill = SUD_STATUS_PILL[b.sudStatus];
                  return (
                    <tr key={b.batchId}>
                      <td style={{ fontFamily: t.fontMono }}>
                        {b.batchId.slice(0, 8)}
                        {b.batchStatus === "discarded" ? (
                          <span style={muted}> · discarded</span>
                        ) : null}
                      </td>
                      <td>
                        <StatusPill label={pill.label} tone={pill.tone} />
                      </td>
                      <td>{usDateTime(b.receivedAt)}</td>
                      <td>{b.pageCount ?? "—"}</td>
                      <td>{b.contributes ? "Yes" : "No"}</td>
                      <td>
                        <Link to={`/intake/${b.batchId}/review`}>Open intake review</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        <Card aria-label="Who can clear what">
          <h2 style={sectionTitle}>Who can clear what</h2>
          <dl style={{ margin: 0, display: "grid", gap: t.space3 }}>
            {(origins.length > 0 ? origins : (["consent", "intake_unconfirmed"] as const)).map(
              (o) => (
                <div key={o}>
                  <dt style={{ fontWeight: 600 }}>{ORIGIN_LABEL[o]}</dt>
                  <dd style={{ margin: 0, ...muted }}>{ORIGIN_CLEARANCE[o]}</dd>
                </div>
              ),
            )}
          </dl>
        </Card>

        <Card aria-label="Change history">
          <h2 style={sectionTitle}>Change history</h2>
          {view.history.length === 0 ? (
            <p style={muted}>No recorded change to this patient's restrictions.</p>
          ) : (
            <ol style={{ margin: 0, paddingLeft: "1.2rem", display: "grid", gap: t.space2 }}>
              {view.history.map((h, i) => (
                <li key={`${h.at}-${i}`}>
                  <strong>{usDateTime(h.at)}</strong> — {flagList(h.flagsBefore)} →{" "}
                  {flagList(h.flagsAfter)}
                  <span style={muted}>
                    {" "}
                    · {h.actorUserId ? `by user ${h.actorUserId.slice(0, 8)}` : "by the system"}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </DetailPageLayout>
  );
}
