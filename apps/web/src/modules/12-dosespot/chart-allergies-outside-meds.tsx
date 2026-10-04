// apps/web/src/modules/12-dosespot/chart-allergies-outside-meds.tsx — F-238, on the patient's Medications
// tab (the prescriber's surface):
//
//   AllergyBanner          M5's allergy list (`GET /api/v1/patients/{id}/allergies`). An UNVERIFIED allergy
//                          — e.g. one a DocLens reviewer attested from a referral fax — is SHOWN, labelled
//                          "Unverified", never hidden: missing an allergy is the unsafe failure. A clinician
//                          can Verify it or mark it Entered in error (reason required). Entered-in-error rows
//                          are not drawn.
//   OutsideMedicationList  M12's medication history (`GET …/medications/history`): the outside medication
//                          lines from a referral fax (source `doclens_intake`) and DoseSpot MedHx fills, each
//                          labelled by source, with the D10 reconciliation decision. Recording a decision
//                          NEVER creates an order (M12 D12) — "Continue" means the prescriber writes the
//                          order in the Prescribe flow; nothing is pre-filled from the fax line.
//
// Both read and write over HTTP only (no M5 import); the server enforces scope and permissions.
import { Panel, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

interface AllergyRow {
  id: string;
  allergenText: string;
  reaction: string | null;
  severity: string | null;
  verificationStatus: "unverified" | "verified" | "entered_in_error";
  source: "intake_extraction" | "clinician_entry";
  sourcePage: number | null;
  reportedAt: string;
}

interface HistoryRow {
  id: string;
  drugName: string;
  source: string;
  sourcePage?: number | null;
  attestedAt?: string | null;
  lastFillDate?: string | null;
  reconciliationDecision?: "carry_forward" | "discontinue" | "document_only" | null;
}

const day = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : "—");

const SOURCE_TEXT: Record<string, string> = {
  intake_extraction: "Referral fax",
  clinician_entry: "Clinician",
};

export function AllergyBanner({ patientId }: { patientId: string }): JSX.Element | null {
  const client = useApiClient();
  const [rows, setRows] = useState<AllergyRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [eie, setEie] = useState<{ id: string; reason: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await client.GET("/api/v1/patients/{id}/allergies", {
      params: { path: { id: patientId } },
    });
    // A response that is not the list shape is a failed read, never "no allergies".
    const list = (data as { allergies?: unknown } | undefined)?.allergies;
    if (error || !Array.isArray(list)) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setRows(list as AllergyRow[]);
  }, [client, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const verify = async (id: string) => {
    setBusy(id);
    setActionError(null);
    const { error } = await client.POST("/api/v1/patients/{id}/allergies/{allergyId}/verify", {
      params: { path: { id: patientId, allergyId: id } },
      body: {},
    });
    setBusy(null);
    if (error) setActionError("Could not verify the allergy.");
    await load();
  };
  const markError = async () => {
    if (!eie || eie.reason.trim().length === 0) return;
    setBusy(eie.id);
    setActionError(null);
    const { error } = await client.POST(
      "/api/v1/patients/{id}/allergies/{allergyId}/entered-in-error",
      {
        params: { path: { id: patientId, allergyId: eie.id } },
        body: { reason: eie.reason.trim() },
      },
    );
    setBusy(null);
    if (error) setActionError("Could not mark the allergy entered in error.");
    else setEie(null);
    await load();
  };

  if (failed) {
    // Never imply "no allergies" when the list could not be read.
    return (
      <Panel title="Allergies" icon="alert" tone="danger">
        <p role="alert" style={{ margin: 0 }}>
          The allergy list could not be loaded. Check allergies on the patient record before
          prescribing.
        </p>
      </Panel>
    );
  }
  if (rows === null) return null;
  const shown = rows.filter((r) => r.verificationStatus !== "entered_in_error");
  const unverified = shown.filter((r) => r.verificationStatus === "unverified").length;

  return (
    <Panel
      title="Allergies"
      icon="alert"
      tone={shown.length > 0 ? "danger" : "default"}
      description={
        unverified > 0
          ? `${unverified} unverified — reported, not yet confirmed by a clinician. Treat as real until verified.`
          : undefined
      }
    >
      {shown.length === 0 ? (
        <p style={{ margin: 0, color: t.onSurfaceVariant }}>No allergies recorded.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.5rem" }}>
          {shown.map((r) => (
            <li key={r.id} style={{ display: "grid", gap: "0.25rem" }}>
              <span
                style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}
              >
                <strong>{r.allergenText}</strong>
                {r.reaction ? <span>— {r.reaction}</span> : null}
                {r.verificationStatus === "unverified" ? (
                  <StatusPill label="Unverified" tone="warning" glyph="alert" />
                ) : (
                  <StatusPill label="Verified" tone="success" />
                )}
                <span style={{ color: t.onSurfaceVariant, fontSize: "0.8125rem" }}>
                  {SOURCE_TEXT[r.source] ?? r.source}
                  {r.sourcePage !== null ? `, page ${r.sourcePage}` : ""} · {day(r.reportedAt)}
                </span>
              </span>
              {r.verificationStatus === "unverified" ? (
                <span style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="wx-btn-secondary"
                    disabled={busy === r.id}
                    onClick={() => void verify(r.id)}
                  >
                    Verify
                  </button>
                  <button
                    type="button"
                    className="wx-btn-secondary"
                    disabled={busy === r.id}
                    onClick={() => setEie({ id: r.id, reason: "" })}
                  >
                    Entered in error
                  </button>
                </span>
              ) : null}
              {eie?.id === r.id ? (
                <span style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                  <input
                    aria-label="Reason this allergy was entered in error"
                    placeholder="Reason (required)"
                    value={eie.reason}
                    onChange={(e) => setEie({ id: r.id, reason: e.target.value })}
                  />
                  <button
                    type="button"
                    className="wx-btn-primary"
                    disabled={eie.reason.trim().length === 0 || busy === r.id}
                    onClick={() => void markError()}
                  >
                    Confirm
                  </button>
                  <button type="button" className="wx-btn-secondary" onClick={() => setEie(null)}>
                    Cancel
                  </button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {actionError ? (
        <p role="alert" style={{ margin: "0.5rem 0 0" }}>
          {actionError}
        </p>
      ) : null}
    </Panel>
  );
}

const DECISION_TEXT: Record<string, string> = {
  carry_forward: "Continue (prescribe separately)",
  discontinue: "Not taking / stopped",
  document_only: "Noted for the record",
};

export function OutsideMedicationList({ patientId }: { patientId: string }): JSX.Element | null {
  const client = useApiClient();
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await client.GET("/api/v1/patients/{patientId}/medications/history", {
      params: { path: { patientId } },
    });
    const list = (data as { records?: unknown } | undefined)?.records;
    setRows(error || !Array.isArray(list) ? [] : (list as HistoryRow[]));
  }, [client, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (
    id: string,
    decision: "carry_forward" | "discontinue" | "document_only",
  ) => {
    setBusy(id);
    setActionError(null);
    const { error } = await client.POST("/api/v1/medication-history-records/{id}/reconcile", {
      params: { path: { id } },
      body: { decision },
    });
    setBusy(null);
    if (error) setActionError("Could not record the reconciliation decision.");
    await load();
  };

  if (rows === null || rows.length === 0) return null;
  return (
    <Panel
      title="Outside medication list"
      icon="pill"
      description="Medications reported from outside sources, for reconciliation. Recording a decision never creates or changes an order — prescribe separately."
    >
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.625rem" }}>
        {rows.map((r) => (
          <li key={r.id} style={{ display: "grid", gap: "0.25rem" }}>
            <span
              style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}
            >
              <strong>{r.drugName}</strong>
              <StatusPill
                label={
                  r.source === "doclens_intake"
                    ? `Referral fax${r.sourcePage != null ? `, p. ${r.sourcePage}` : ""} · reviewed ${day(r.attestedAt)}`
                    : `Pharmacy fill history · last fill ${r.lastFillDate ?? "—"}`
                }
                tone="neutral"
              />
              {r.reconciliationDecision ? (
                <StatusPill
                  label={DECISION_TEXT[r.reconciliationDecision] ?? r.reconciliationDecision}
                  tone="success"
                />
              ) : (
                <StatusPill label="To reconcile" tone="progress" />
              )}
            </span>
            {r.reconciliationDecision ? null : (
              <span style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                {(["carry_forward", "discontinue", "document_only"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    className="wx-btn-secondary"
                    disabled={busy === r.id}
                    onClick={() => void decide(r.id, d)}
                  >
                    {DECISION_TEXT[d]}
                  </button>
                ))}
              </span>
            )}
          </li>
        ))}
      </ul>
      {actionError ? (
        <p role="alert" style={{ margin: "0.5rem 0 0" }}>
          {actionError}
        </p>
      ) : null}
    </Panel>
  );
}
